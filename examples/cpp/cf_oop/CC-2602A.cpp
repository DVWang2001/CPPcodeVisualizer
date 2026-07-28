#include<iostream>
#include<vector>
#include<numeric>
using namespace std;
class Point{public:
   double m_x,m_y;
   Point(double x=0,double y=0){m_x=x;m_y=y;}
   Point operator+(Point b){return Point(m_x+b.m_x,m_y+b.m_y);}
   Point operator/(double b){return Point(m_x/b,m_y/b);}
};
istream& operator>>(istream &is,Point&a){return is>>a.m_x>>a.m_y;}
ostream& operator<<(ostream &os,const Point&a){return os<<"("<<a.m_x<<","<<a.m_y<<")";}
class PVec{public:
   vector<Point> m_pts;//向量容器
   PVec(int n):m_pts(n){}
   Point sum(){return accumulate(m_pts.begin(),m_pts.end(),Point());}
   Point avg(){return sum()/m_pts.size();}
};
istream& operator>>(istream &is,PVec&a){
   for(int k=0;k<a.m_pts.size();k++)is>>a.m_pts[k];
   return is;
}
ostream& operator<<(ostream &os,PVec&a){
   return os<<"sum:"<<a.sum()<<endl<<"avg:"<<a.avg()<<endl;
}
int main(){
   int n;cin>>n;
   PVec pts(n);
   cin>>pts;
   cout<<pts;  //@ @guide uml:pts
   return 0;
}
