#include<iostream>
#include<vector>
#include<numeric>
using namespace std;
class Point{
   double m_x,m_y,m_z;
public:
   Point(double x=0,double y=0):m_x(x),m_y(y){}
   Point operator+(const Point& b){
      return Point(m_x+b.m_x,m_y+b.m_y);
   }
   Point operator/(double b){return Point(m_x/b,m_y/b);}
   friend istream& operator>>(istream &is,Point&a);
   friend ostream& operator<<(ostream &os,const Point&a);
};
istream& operator>>(istream &is,Point&a){return is>>a.m_x>>a.m_y;}
ostream& operator<<(ostream &os,const Point&a){
   return os<<"("<<a.m_x<<","<<a.m_y<<")";
}
class PVec{
   vector<Point> m_pts;
public:
   PVec(int n):m_pts(n){}
   Point sum()const{
      return accumulate(m_pts.begin(),m_pts.end(),Point());
   }
   Point avg()const{return sum()/m_pts.size();}
   friend istream& operator>>(istream &,PVec&);
   friend ostream& operator<<(ostream &,const PVec&);
};
istream& operator>>(istream &is,PVec&a){
   for(int k=0;k<a.m_pts.size();k++)cin>>a.m_pts[k];
   return is;
}
ostream& operator<<(ostream &os,const PVec &a){
   return os<<"sum:"<<a.sum()<<endl<<"avg:"<<a.avg()<<endl;
}
int main(){
   int n;cin>>n;
   PVec pts(n);
   cin>>pts;
   cout<<pts;  //@ @guide uml:pts
   return 0;
}
