#include<iostream>
#include<vector>
#include<numeric>
using namespace std;
class Point{
   double m_x,m_y;
   static int s;
public:
   Point(double x=0,double y=0):m_x(x),m_y(y){s++;}
   Point(const Point& b):m_x(b.m_x),m_y(b.m_y){s++;}
   ~Point(){s--;}
   Point operator+(const Point& b)const{return Point(m_x+b.m_x,m_y+b.m_y);}
   Point operator/(double b)const{return Point(m_x/b,m_y/b);}
   static int Population(){return s;}
   friend istream& operator>>(istream &is,Point &a);
   friend ostream& operator<<(ostream &os,const Point&a);
};
int Point::s=0;
istream& operator>>(istream &is,Point&a){return is>>a.m_x>>a.m_y;}
ostream& operator<<(ostream &os,const Point&a){
   return os<<"("<<a.m_x<<","<<a.m_y<<")";
}
class PVec:public vector<Point>{
   public:
   PVec(int n):vector<Point>(n){}
   Point sum()const{return accumulate(begin(),end(),Point());}
   Point avg()const{return sum()/size();}
};
istream& operator>>(istream &is,PVec&a){
   for(int k=0;k<a.size();k++)is>>a[k];
   return is;
}
ostream& operator<<(ostream &os,const PVec &a){
   return os<<"sum:"<<a.sum()<<endl<<"avg:"<<a.avg()<<endl;
}
int main(){
   {
   	int n;cin>>n;
	PVec pts(n);cin>>pts;
	cout<<pts<<endl;  //@ @guide uml:pts
	cout<<Point::Population()<<endl;
   }
   cout<<Point::Population()<<endl;
   return 0;
}
